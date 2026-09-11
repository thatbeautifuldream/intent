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

const EASE_SMOOTH_OUT = Easing.bezier(0.22, 1, 0.36, 1);
// transitions.dev maps a position change to --duration-fast + --ease-smooth-out.
// LayoutAnimation only exposes named curves, so easeOut stands in for the bezier.
const DURATION_QUICK = 150;
const DURATION_FAST = 250;
// transitions.dev: the row leaves on --duration-quick while the rows below it
// close the gap on --duration-fast, both on the smooth-out curve that
// LayoutAnimation approximates with easeOut.
const REMOVE_ANIMATION = {
  duration: DURATION_FAST,
  update: { type: LayoutAnimation.Types.easeOut, duration: DURATION_FAST },
  delete: {
    type: LayoutAnimation.Types.easeOut,
    property: LayoutAnimation.Properties.opacity,
    duration: DURATION_QUICK,
  },
};

const REORDER_ANIMATION = {
  duration: DURATION_FAST,
  update: { type: LayoutAnimation.Types.easeOut },
  delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
};

// A right swipe slides the row aside to uncover the actions beneath it, so the
// travel is exactly their footprint: two Material 48dp touch targets with
// matching margins either side.
const ACTION_SIZE = 48;
const ACTION_INSET = 12;
const ACTION_COUNT = 2;
const ACTION_WIDTH = ACTION_INSET * 2 + ACTION_SIZE * ACTION_COUNT;
const SWIPE_THRESHOLD = ACTION_WIDTH / 2;

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
  const listRef = useRef<FlatList<InstalledApp> | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string>();
  const reduceMotion = useReduceMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const scrollY = useRef(new Animated.Value(0)).current;
  const [overflow, setOverflow] = useState(0);
  const metrics = useRef({ content: 0, layout: 0 });

  const loadApps = useRef(() => {
    LauncherModule.getInstalledApps().then(setApps).catch(showError);
  });

  useEffect(() => {
    loadApps.current();
  }, []);

  // The system tells the launcher when packages are installed, updated or
  // removed, so the list is rebuilt exactly when it changes and never polled.
  // Package operations arrive in bursts, hence the short coalescing window.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout>;

    const subscription = LauncherModule.addListener("onAppsChanged", ({ removed }) => {
      // An uninstall is answered from the list we already hold, the way
      // Launcher3 removes components rather than reloading its model. Waiting on
      // a debounce and a full re-query just to delete a row you already know
      // about is what made this feel slow.
      if (removed.length) {
        if (!reduceMotionRef.current) {
          LayoutAnimation.configureNext(REMOVE_ANIMATION);
        }
        setApps((current) => {
          const gone = current.filter((app) =>
            removed.includes(app.packageName),
          );
          dropPins(gone.map((app) => app.id));
          return current.filter((app) => !removed.includes(app.packageName));
        });
        return;
      }

      clearTimeout(pending);
      pending = setTimeout(() => loadApps.current(), 250);
    });

    return () => {
      clearTimeout(pending);
      subscription.remove();
    };
  }, []);

  // Home means "a clean home screen": nothing left open, back at the top.
  useEffect(() => {
    const subscription = LauncherModule.addListener("onHomeIntent", () => {
      setOpenRow(undefined);

      const list = listRef.current as unknown as {
        scrollToOffset?: (options: { offset: number; animated: boolean }) => void;
      } | null;

      list?.scrollToOffset?.({ offset: 0, animated: true });
    });

    return () => subscription.remove();
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

  function launchApp(app: InstalledApp) {
    LauncherModule.launchApp(app.component, app.user).catch((reason) => {
      // A row that will not launch is a stale entry, so rebuild the list rather
      // than leaving the user tapping something that cannot work.
      loadApps.current();
      showError(reason);
    });
  }

  function openAppInfo(app: InstalledApp) {
    LauncherModule.openAppInfo(app.component, app.user).catch(showError);
    setOpenRow(undefined);
  }

  // An uninstalled app must not linger in the persisted pin order.
  function dropPins(ids: string[]) {
    setPinned((current) => {
      const next = current.filter((id) => !ids.includes(id));

      if (next.length !== current.length) {
        Store.setItem(PINNED_KEY, JSON.stringify(next)).catch(showError);
      }

      return next;
    });
  }

  // Most recently pinned first, so a freshly pinned app lands at the very top.
  function togglePin(id: string) {
    const next = pinned.includes(id)
      ? pinned.filter((pinnedId) => pinnedId !== id)
      : [id, ...pinned];

    if (!reduceMotion) {
      LayoutAnimation.configureNext(REORDER_ANIMATION);
    }

    setPinned(next);
    setOpenRow(undefined);
    Store.setItem(PINNED_KEY, JSON.stringify(next)).catch(showError);
  }

  // No overflow, no fade — the same rule the CSS utility follows.
  function measure(next: Partial<{ content: number; layout: number }>) {
    const merged = { ...metrics.current, ...next };

    if (
      merged.content === metrics.current.content &&
      merged.layout === metrics.current.layout
    ) {
      return;
    }

    metrics.current = merged;
    setOverflow(Math.max(0, merged.content - merged.layout));
  }

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      // The scroll event is the authoritative source for both sizes. The list's
      // own onLayout reports a height that is not the viewport, which left the
      // bottom fade computing against a scroll range several times too large.
      listener: (event: {
        nativeEvent: {
          contentSize: { height: number };
          layoutMeasurement: { height: number };
        };
      }) =>
        measure({
          content: event.nativeEvent.contentSize.height,
          layout: event.nativeEvent.layoutMeasurement.height,
        }),
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
    const byId = new Map(apps.map((app) => [app.id, app]));
    const top = pinned
      .map((id) => byId.get(id))
      .filter((app): app is InstalledApp => Boolean(app));
    const rest = apps.filter((app) => !pinned.includes(app.id));

    return [...top, ...rest];
  }, [apps, pinned]);

  const footerHeight = insets.bottom + (isDefault ? 24 : 76);

  return (
    <View
      style={styles.screen}
      onLayout={(event) => measure({ layout: event.nativeEvent.layout.height })}
    >
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
        keyExtractor={(app) => app.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: footerHeight + 32,
        }}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onContentSizeChange={(_width, height) => measure({ content: height })}
        ListEmptyComponent={<Text style={styles.muted}>No apps yet</Text>}
        renderItem={({ item }) => (
          <AppRow
            name={item.name}
            reduceMotion={reduceMotion}
            isPinned={pinned.includes(item.id)}
            isOpen={openRow === item.id}
            onOpen={() => setOpenRow(item.id)}
            onClose={() => setOpenRow(undefined)}
            onPin={() => togglePin(item.id)}
            onInfo={() => openAppInfo(item)}
            onPress={() => launchApp(item)}
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
  reduceMotion: boolean;
  isPinned: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPin: () => void;
  onInfo: () => void;
  onPress: () => void;
}) {
  const press = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;
  const open = useRef(false);

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
                transform: [
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
