import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  FlatList,
  type FlatListProps,
  Image,
  LayoutAnimation,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Button, Host, Text as NativeText } from "@expo/ui/jetpack-compose";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import Store from "expo-sqlite/kv-store";

import LauncherModule, { type InstalledApp } from "./modules/launcher";

const PINNED_KEY = "pinned-apps";
// Android drawable resources, shipped by the config plugin rather than the
// bundler, so they resolve identically in development and in a release build.
const PIN_ICON = { uri: "ic_pin" };
const UNPIN_ICON = { uri: "ic_unpin" };
const INFO_ICON = { uri: "ic_info" };

const BACKGROUND = "#000000";
const TOP_FADE = 56;
const BOTTOM_FADE = 120;

// Ported from shadcn's `scroll-fade`: the edge fade tracks scroll position
// rather than sitting there permanently. At rest the top is crisp and the
// bottom hints at more content; at the end the bottom sharpens. Each edge eases
// over this reveal distance (their --scroll-fade-reveal default). CSS does it
// with mask-image; on a solid background a black gradient overlay is
// equivalent, so this stays a LinearGradient rather than a native mask view.
const SCROLL_FADE_REVEAL = 96;

// A hairline scroll indicator that doubles as a scrubber. It scrolls freely —
// only the haptic is quantised, ticking as the drag crosses into a new initial.
const TRACK_WIDTH = 2;
const THUMB_HEIGHT = 48;
const SCRUBBER_TOUCH_WIDTH = 36;

const EASE_SMOOTH_OUT = Easing.bezier(0.22, 1, 0.36, 1);
// transitions.dev maps a position change to --duration-fast + --ease-smooth-out.
// LayoutAnimation only exposes named curves, so easeOut stands in for the bezier.
const DURATION_FAST = 250;
const REORDER_ANIMATION = {
  duration: DURATION_FAST,
  update: { type: LayoutAnimation.Types.easeOut },
  delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
};
const DURATION_VERY_SLOW = 420;

// A right swipe slides the row aside to uncover the actions beneath it, so the
// travel is exactly their footprint: two Material 48dp touch targets with
// matching margins either side.
const ACTION_SIZE = 48;
const ACTION_INSET = 12;
const ACTION_COUNT = 2;
const ACTION_WIDTH = ACTION_INSET * 2 + ACTION_SIZE * ACTION_COUNT;
const SWIPE_THRESHOLD = ACTION_WIDTH / 2;
const STAGGER_MS = 28;
const MAX_STAGGERED = 14;

const AnimatedFlatList = Animated.FlatList as unknown as React.ComponentType<
  FlatListProps<InstalledApp> & { ref?: React.Ref<FlatList<InstalledApp>> }
>;
const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient);

export default function App() {
  return (
    <SafeAreaProvider>
      <Launcher />
    </SafeAreaProvider>
  );
}

function Launcher() {
  const insets = useSafeAreaInsets();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [openRow, setOpenRow] = useState<string>();
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string>();
  const reduceMotion = useReduceMotion();

  const scrollY = useRef(new Animated.Value(0)).current;
  const [overflow, setOverflow] = useState(0);
  const metrics = useRef({ content: 0, layout: 0 });
  // Animated.FlatList wraps the list, and the wrapper does not expose the
  // scroll methods, so keep a handle on whichever object actually has them.
  const listRef = useRef<FlatList<InstalledApp> | null>(null);
  const rowHeight = useRef(0);
  const [trackHeight, setTrackHeight] = useState(0);
  // The thumb is a plain number: one source of truth, written by the scroll
  // listener and by the drag, with no native/JS animated values to keep in sync.
  const [thumbY, setThumbY] = useState(0);
  const [scrubbing, setScrubbing] = useState<string | undefined>(undefined);
  const scrubbingRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    LauncherModule.getInstalledApps().then(setApps).catch(showError);
  }, []);

  useEffect(() => {
    Store.getItem(PINNED_KEY)
      .then((stored) => setPinned(stored ? JSON.parse(stored) : []))
      .catch(showError);
  }, []);

  useEffect(() => {
    const check = () =>
      LauncherModule.isDefaultLauncher().then(setIsDefault).catch(showError);

    check();
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        check();
      }
    });
    return () => subscription.remove();
  }, []);

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  function launchApp(packageName: string) {
    LauncherModule.launchApp(packageName).catch(showError);
  }

  function openAppInfo(packageName: string) {
    LauncherModule.openAppInfo(packageName).catch(showError);
    setOpenRow(undefined);
  }

  // Most recently pinned first, so a freshly pinned app lands at the very top.
  function togglePin(packageName: string) {
    const next = pinned.includes(packageName)
      ? pinned.filter((name) => name !== packageName)
      : [packageName, ...pinned];

    if (!reduceMotion) {
      LayoutAnimation.configureNext(REORDER_ANIMATION);
    }

    setPinned(next);
    setOpenRow(undefined);
    Store.setItem(PINNED_KEY, JSON.stringify(next)).catch(showError);
  }

  // No overflow, no fade — the same rule the CSS utility follows.
  function measure(next: Partial<{ content: number; layout: number }>) {
    metrics.current = { ...metrics.current, ...next };
    const { content, layout } = metrics.current;
    setOverflow(Math.max(0, content - layout));
  }

  const scrubRef = useRef(scrubTo);
  scrubRef.current = scrubTo;
  const endScrubRef = useRef(endScrub);
  endScrubRef.current = endScrub;

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
        if (scrubbingRef.current || !overflow || !trackHeight) {
          return;
        }
        const progress = event.nativeEvent.contentOffset.y / overflow;
        setThumbY(
          Math.max(0, Math.min(1, progress)) *
            Math.max(0, trackHeight - THUMB_HEIGHT),
        );
      },
    },
  );

  const topFade = overflow
    ? scrollY.interpolate({
        inputRange: [0, SCROLL_FADE_REVEAL],
        outputRange: [0, 1],
        extrapolate: "clamp",
      })
    : 0;

  const bottomFade = overflow
    ? scrollY.interpolate({
        inputRange: [
          Math.max(0, overflow - SCROLL_FADE_REVEAL),
          Math.max(1, overflow),
        ],
        outputRange: [1, 0],
        extrapolate: "clamp",
      })
    : 0;

  const ordered = useMemo(() => {
    const byPackage = new Map(apps.map((app) => [app.packageName, app]));
    const top = pinned
      .map((packageName) => byPackage.get(packageName))
      .filter((app): app is InstalledApp => Boolean(app));
    const rest = apps.filter((app) => !pinned.includes(app.packageName));

    return [...top, ...rest];
  }, [apps, pinned]);

  // One entry per initial that actually appears, so the scrubber never offers a
  // letter that goes nowhere.
  const letters = useMemo(() => {
    const first = new Map<string, number>();

    ordered.forEach((app, index) => {
      const initial = app.name[0]?.toUpperCase() ?? "#";
      const key = initial >= "A" && initial <= "Z" ? initial : "#";
      if (!first.has(key)) {
        first.set(key, index);
      }
    });

    return [...first.entries()].sort(([a], [b]) =>
      a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b),
    );
  }, [ordered]);

  function scrubTo(y: number) {
    if (!trackHeight || !rowHeight.current || !ordered.length) {
      return;
    }

    // Scroll has to be mapped over the thumb's travel, not the whole track:
    // mapping against trackHeight leaves the last THUMB_HEIGHT of the range
    // unreachable, so the list never quite hits the bottom.
    const travel = Math.max(1, trackHeight - THUMB_HEIGHT);
    const top = Math.max(0, Math.min(travel, y - THUMB_HEIGHT / 2));

    setThumbY(top);

    const offset = (top / travel) * overflow;
    const index = Math.max(
      0,
      Math.min(ordered.length - 1, Math.round(offset / rowHeight.current)),
    );
    const initial = ordered[index].name[0]?.toUpperCase() ?? "#";
    const letter = initial >= "A" && initial <= "Z" ? initial : "#";

    if (letter !== scrubbingRef.current) {
      scrubbingRef.current = letter;
      Haptics.selectionAsync().catch(() => {});
    }

    setScrubbing(letter);

    const list = listRef.current as unknown as {
      scrollToOffset?: (options: { offset: number; animated: boolean }) => void;
      getScrollResponder?: () => {
        scrollTo?: (options: { y: number; animated: boolean }) => void;
      };
    } | null;

    if (list?.scrollToOffset) {
      list.scrollToOffset({ offset, animated: false });
    } else {
      list?.getScrollResponder?.()?.scrollTo?.({ y: offset, animated: false });
    }
  }

  function endScrub() {
    scrubbingRef.current = undefined;
    setScrubbing(undefined);
  }

  const scrubber = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => scrubRef.current(event.nativeEvent.locationY),
      onPanResponderMove: (event) => scrubRef.current(event.nativeEvent.locationY),
      onPanResponderRelease: () => endScrubRef.current(),
      onPanResponderTerminate: () => endScrubRef.current(),
    }),
  ).current;

  const footerHeight = insets.bottom + (isDefault ? 24 : 76);

  return (
    <View style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="light-content"
      />

      <AnimatedFlatList
        ref={(instance: unknown) => {
          const node = instance as
            | (FlatList<InstalledApp> & { getNode?: () => FlatList<InstalledApp> })
            | null;
          listRef.current = node?.getNode?.() ?? node;
        }}
        data={ordered}
        keyExtractor={(app) => app.packageName}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: footerHeight + 32,
        }}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onLayout={(event) =>
          measure({ layout: event.nativeEvent.layout.height })
        }
        onContentSizeChange={(_width, height) => measure({ content: height })}
        ListEmptyComponent={<Text style={styles.muted}>No apps yet</Text>}
        renderItem={({ item, index }) => (
          <AppRow
            name={item.name}
            onMeasure={index === 0 ? (height) => (rowHeight.current = height) : undefined}
            delay={Math.min(index, MAX_STAGGERED) * STAGGER_MS}
            reduceMotion={reduceMotion}
            isPinned={pinned.includes(item.packageName)}
            isOpen={openRow === item.packageName}
            onOpen={() => setOpenRow(item.packageName)}
            onClose={() => setOpenRow(undefined)}
            onPin={() => togglePin(item.packageName)}
            onInfo={() => openAppInfo(item.packageName)}
            onPress={() => launchApp(item.packageName)}
          />
        )}
      />

      <AnimatedGradient
        pointerEvents="none"
        colors={[BACKGROUND, BACKGROUND, "transparent"]}
        locations={[0, insets.top / (insets.top + TOP_FADE), 1]}
        style={[
          styles.fade,
          { top: 0, height: insets.top + TOP_FADE, opacity: topFade },
        ]}
      />
      <AnimatedGradient
        pointerEvents="none"
        colors={["transparent", BACKGROUND, BACKGROUND]}
        locations={[0, BOTTOM_FADE / (insets.bottom + BOTTOM_FADE), 1]}
        style={[
          styles.fade,
          {
            bottom: 0,
            height: insets.bottom + BOTTOM_FADE,
            opacity: bottomFade,
          },
        ]}
      />

      {overflow && letters.length > 4 ? (
        <View
          {...scrubber.panHandlers}
          pointerEvents="box-only"
          onLayout={(event) => setTrackHeight(event.nativeEvent.layout.height)}
          style={[
            styles.scrubber,
            { top: insets.top + 40, bottom: footerHeight + 24 },
          ]}
        >
          <View style={styles.track} />
          <View
            style={[
              styles.thumb,
              scrubbing ? styles.thumbActive : null,
              { top: thumbY },
            ]}
          />
          {scrubbing ? (
            <View style={[styles.bubble, { top: thumbY }]}>
              <Text style={styles.bubbleLetter}>{scrubbing}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {isDefault ? null : (
          <Host matchContents>
            <Button
              onClick={() => LauncherModule.requestHomeRole().catch(showError)}
              colors={{ containerColor: "#141414", contentColor: "#9A9A9A" }}
              contentPadding={{ start: 20, end: 20, top: 6, bottom: 6 }}
            >
              <NativeText style={{ fontSize: 13, letterSpacing: 0.2 }}>
                Set as default
              </NativeText>
            </Button>
          </Host>
        )}
      </View>
    </View>
  );
}

function AppRow({
  name,
  onMeasure,
  delay,
  reduceMotion,
  isPinned,
  isOpen,
  onOpen,
  onClose,
  onPin,
  onInfo,
  onPress,
}: {
  name: string;
  onMeasure?: (height: number) => void;
  delay: number;
  reduceMotion: boolean;
  isPinned: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPin: () => void;
  onInfo: () => void;
  onPress: () => void;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const open = useRef(false);

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: reduceMotion ? 0 : DURATION_VERY_SLOW,
      delay: reduceMotion ? 0 : delay,
      easing: EASE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
    // Entrance runs once per row.
  }, []);

  useEffect(() => {
    open.current = isOpen;
    settle(isOpen ? ACTION_WIDTH : 0);
  }, [isOpen]);

  function settle(toValue: number) {
    Animated.timing(slide, {
      toValue,
      duration: reduceMotion ? 0 : DURATION_FAST,
      easing: EASE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
  }

  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const settleRef = useRef(settle);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;
  settleRef.current = settle;

  // The list scrolls vertically, so only claim clearly horizontal drags.
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 12 &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
      onPanResponderMove: (_event, gesture) => {
        const base = open.current ? ACTION_WIDTH : 0;
        slide.setValue(
          Math.max(0, Math.min(ACTION_WIDTH, base + gesture.dx)),
        );
      },
      onPanResponderRelease: (_event, gesture) => {
        const base = open.current ? ACTION_WIDTH : 0;
        const shouldOpen = base + gesture.dx >= SWIPE_THRESHOLD;
        if (shouldOpen) {
          onOpenRef.current();
        } else {
          onCloseRef.current();
        }
        settleRef.current(shouldOpen ? ACTION_WIDTH : 0);
      },
    }),
  ).current;

  const dim = press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] });

  return (
    <View>
      <View style={styles.action}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isPinned ? `Unpin ${name}` : `Pin ${name}`}
          onPress={onPin}
          style={styles.actionTarget}
        >
          <Image
            source={isPinned ? UNPIN_ICON : PIN_ICON}
            style={styles.actionIcon}
            tintColor="#8A8A8A"
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`App info for ${name}`}
          onPress={onInfo}
          style={styles.actionTarget}
        >
          <Image
            source={INFO_ICON}
            style={styles.actionIcon}
            tintColor="#8A8A8A"
          />
        </Pressable>
      </View>

      <Animated.View
        {...swipe.panHandlers}
        onLayout={(event) => onMeasure?.(event.nativeEvent.layout.height)}
        style={{ transform: [{ translateX: slide }] }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={isOpen ? onClose : onPress}
          onPressIn={() =>
            Animated.spring(press, {
              toValue: 1,
              speed: 40,
              bounciness: 0,
              useNativeDriver: true,
            }).start()
          }
          onPressOut={() =>
            Animated.spring(press, {
              toValue: 0,
              speed: 20,
              bounciness: 6,
              useNativeDriver: true,
            }).start()
          }
        >
          <Animated.View
            style={[
              styles.row,
              {
                opacity: enter,
                transform: [
                  {
                    translateY: enter.interpolate({
                      inputRange: [0, 1],
                      outputRange: [16, 0],
                    }),
                  },
                  {
                    scale: press.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 0.97],
                    }),
                  },
                ],
              },
            ]}
          >
            <Animated.Text
              numberOfLines={1}
              style={[styles.name, { opacity: dim }]}
            >
              {name}
            </Animated.Text>
          </Animated.View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => subscription.remove();
  }, []);

  return reduceMotion;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  row: {
    paddingHorizontal: 28,
    paddingVertical: 13,
    backgroundColor: BACKGROUND,
  },
  action: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: ACTION_INSET,
    flexDirection: "row",
    alignItems: "center",
  },
  actionTarget: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  actionIcon: {
    width: 20,
    height: 20,
  },
  name: {
    color: "#F2F2F2",
    fontSize: 21,
    fontWeight: "300",
    letterSpacing: 0.2,
  },
  muted: {
    paddingHorizontal: 28,
    color: "#6B6B6B",
    fontSize: 16,
    fontWeight: "300",
  },
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  scrubber: {
    position: "absolute",
    right: 0,
    width: SCRUBBER_TOUCH_WIDTH,
    // The bubble hangs to the left of the touch strip, so it must not be clipped.
    overflow: "visible",
  },
  track: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 14,
    width: TRACK_WIDTH,
    backgroundColor: "#1C1C1C",
  },
  thumb: {
    position: "absolute",
    right: 14,
    width: TRACK_WIDTH,
    height: THUMB_HEIGHT,
    backgroundColor: "#3A3A3A",
  },
  thumbActive: {
    backgroundColor: "#F2F2F2",
  },
  // Sits well clear of the track so a thumb resting on the slider cannot cover
  // it. The one square corner points back at the track, droplet style.
  bubble: {
    position: "absolute",
    right: 64,
    height: THUMB_HEIGHT,
    minWidth: THUMB_HEIGHT + 16,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1A1A1A",
    borderRadius: THUMB_HEIGHT / 2,
    borderBottomRightRadius: 6,
  },
  bubbleLetter: {
    color: "#F2F2F2",
    fontSize: 20,
    fontWeight: "300",
    letterSpacing: 0.2,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  error: {
    marginBottom: 12,
    textAlign: "center",
    color: "#FF6B6B",
    fontSize: 13,
  },
});
