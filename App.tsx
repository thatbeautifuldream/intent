import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  FlatList,
  type FlatListProps,
  LayoutAnimation,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Button,
  Host,
  Icon,
  IconButton,
  Text as NativeText,
  Row,
} from "@expo/ui/jetpack-compose";
import { LinearGradient } from "expo-linear-gradient";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import Store from "expo-sqlite/kv-store";

import LauncherModule, { type InstalledApp } from "./modules/launcher";

const PINNED_KEY = "pinned-apps";
const PIN_ICON = require("./assets/icons/pin.xml");
const UNPIN_ICON = require("./assets/icons/unpin.xml");
const INFO_ICON = require("./assets/icons/info.xml");

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
  FlatListProps<InstalledApp>
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
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [hasNotificationAccess, setHasNotificationAccess] = useState(true);
  const [pinned, setPinned] = useState<string[]>([]);
  const [openRow, setOpenRow] = useState<string>();
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string>();
  const reduceMotion = useReduceMotion();

  const scrollY = useRef(new Animated.Value(0)).current;
  const [overflow, setOverflow] = useState(0);
  const metrics = useRef({ content: 0, layout: 0 });

  useEffect(() => {
    LauncherModule.getInstalledApps().then(setApps).catch(showError);
  }, []);

  useEffect(() => {
    Store.getItem(PINNED_KEY)
      .then((stored) => setPinned(stored ? JSON.parse(stored) : []))
      .catch(showError);
  }, []);

  useEffect(() => {
    const check = () => {
      LauncherModule.isDefaultLauncher().then(setIsDefault).catch(showError);
      setHasNotificationAccess(LauncherModule.hasNotificationAccess());
      setCounts(LauncherModule.getNotificationCounts());
    };

    check();
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        check();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = LauncherModule.addListener(
      "onNotificationsChanged",
      (payload) => setCounts(payload.counts),
    );
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

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: true },
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

  // One-time setup prompts share the footer slot and retire once satisfied.
  const setup = !isDefault
    ? {
        label: "Set as default",
        onPress: () => LauncherModule.requestHomeRole().catch(showError),
      }
    : !hasNotificationAccess
      ? {
          label: "Show notifications",
          onPress: () =>
            LauncherModule.requestNotificationAccess().catch(showError),
        }
      : undefined;

  const footerHeight = insets.bottom + (setup ? 76 : 24);

  return (
    <View style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="light-content"
      />

      <AnimatedFlatList
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
            delay={Math.min(index, MAX_STAGGERED) * STAGGER_MS}
            reduceMotion={reduceMotion}
            count={counts[item.packageName] ?? 0}
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

      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {setup ? (
          <Host matchContents>
            <Button
              onClick={setup.onPress}
              colors={{ containerColor: "#141414", contentColor: "#9A9A9A" }}
              contentPadding={{ start: 20, end: 20, top: 6, bottom: 6 }}
            >
              <NativeText style={{ fontSize: 13, letterSpacing: 0.2 }}>
                {setup.label}
              </NativeText>
            </Button>
          </Host>
        ) : null}
      </View>
    </View>
  );
}

function AppRow({
  name,
  count,
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
  count: number;
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
        Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
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
        <Host style={styles.actionHost}>
          <Row verticalAlignment="center">
            <IconButton onClick={onPin}>
              <Icon
                source={isPinned ? UNPIN_ICON : PIN_ICON}
                size={20}
                tint="#8A8A8A"
                contentDescription={isPinned ? `Unpin ${name}` : `Pin ${name}`}
              />
            </IconButton>
            <IconButton onClick={onInfo}>
              <Icon
                source={INFO_ICON}
                size={20}
                tint="#8A8A8A"
                contentDescription={`App info for ${name}`}
              />
            </IconButton>
          </Row>
        </Host>
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
            <Animated.View style={[styles.label, { opacity: dim }]}>
              <Text numberOfLines={1} style={styles.name}>
                {name}
              </Text>
              {count ? (
                <Text style={styles.count}>
                  {count === 1 ? "*" : `(${count})`}
                </Text>
              ) : null}
            </Animated.View>
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
    justifyContent: "center",
  },
  actionHost: {
    width: ACTION_SIZE * ACTION_COUNT,
    height: ACTION_SIZE,
  },
  label: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  name: {
    color: "#F2F2F2",
    fontSize: 21,
    fontWeight: "300",
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  count: {
    marginLeft: 8,
    color: "#8A8A8A",
    fontSize: 14,
    fontWeight: "300",
    fontVariant: ["tabular-nums"],
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
