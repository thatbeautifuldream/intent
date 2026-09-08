import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  type FlatListProps,
  Keyboard,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button, Host, Text as NativeText } from "@expo/ui/jetpack-compose";
import { LinearGradient } from "expo-linear-gradient";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import LauncherModule, { type InstalledApp } from "./modules/launcher";

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

// Motion tokens: transitions.dev scale, applied to Animated instead of CSS.
const EASE_SMOOTH_OUT = Easing.bezier(0.22, 1, 0.36, 1);
const DURATION_MEDIUM = 350;
const DURATION_SLOW = 400;
const DURATION_VERY_SLOW = 420;
const DISTANCE_MEDIUM = 12;
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
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const reduceMotion = useReduceMotion();

  const search = useRef(new Animated.Value(0)).current;
  const scrollY = useRef(new Animated.Value(0)).current;
  const [overflow, setOverflow] = useState(0);
  const metrics = useRef({ content: 0, layout: 0 });

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
        inputRange: [Math.max(0, overflow - SCROLL_FADE_REVEAL), Math.max(1, overflow)],
        outputRange: [1, 0],
        extrapolate: "clamp",
      })
    : 0;

  useEffect(() => {
    LauncherModule.getInstalledApps().then(setApps).catch(showError);
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

  useEffect(() => {
    if (!searching) {
      return;
    }
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        closeSearch();
        return true;
      },
    );
    return () => subscription.remove();
  }, [searching]);

  const results = useMemo(() => rank(apps, query), [apps, query]);

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  function openSearch() {
    if (searching) {
      return;
    }
    setSearching(true);
    scrollY.setValue(0);
    metrics.current = { content: 0, layout: metrics.current.layout };
    Animated.timing(search, {
      toValue: 1,
      duration: reduceMotion ? 0 : DURATION_SLOW,
      easing: EASE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
  }

  function closeSearch() {
    Keyboard.dismiss();
    Animated.timing(search, {
      toValue: 0,
      duration: reduceMotion ? 0 : DURATION_MEDIUM,
      easing: EASE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start(() => {
      setSearching(false);
      setQuery("");
      scrollY.setValue(0);
    });
  }

  function launchApp(packageName: string) {
    LauncherModule.launchApp(packageName).catch(showError);
    if (searching) {
      closeSearch();
    }
  }

  const footerHeight = insets.bottom + (isDefault ? 68 : 120);
  const listPadding = {
    paddingTop: insets.top + 24,
    paddingBottom: footerHeight + 32,
  };

  return (
    <View style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="light-content"
      />

      <Animated.View
        pointerEvents={searching ? "none" : "auto"}
        style={[
          styles.layer,
          {
            opacity: search.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0],
            }),
          },
        ]}
      >
        <AnimatedFlatList
          data={apps}
          keyExtractor={(app) => app.packageName}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={listPadding}
          scrollEventThrottle={16}
          onScroll={onScroll}
          onLayout={(event) =>
            measure({ layout: event.nativeEvent.layout.height })
          }
          onContentSizeChange={(_width, height) =>
            measure({ content: height })
          }
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={openSearch}
              colors={["transparent"]}
              progressBackgroundColor="transparent"
              progressViewOffset={insets.top}
            />
          }
          ListEmptyComponent={<Text style={styles.muted}>No apps yet</Text>}
          renderItem={({ item, index }) => (
            <AppRow
              name={item.name}
              delay={Math.min(index, MAX_STAGGERED) * STAGGER_MS}
              reduceMotion={reduceMotion}
              onPress={() => launchApp(item.packageName)}
            />
          )}
        />
      </Animated.View>

      <Animated.View
        pointerEvents={searching ? "auto" : "none"}
        style={[
          styles.layer,
          {
            opacity: search,
            transform: [
              {
                translateY: search.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-DISTANCE_MEDIUM, 0],
                }),
              },
            ],
          },
        ]}
      >
        {searching ? (
          <>
            <View style={[styles.field, { paddingTop: insets.top + 24 }]}>
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={() => {
                  const first = results[0];
                  if (first) {
                    launchApp(first.packageName);
                  }
                }}
                placeholder="Search"
                placeholderTextColor="#5A5A5A"
                selectionColor="#3A3A3A"
                cursorColor="#F2F2F2"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                style={styles.input}
              />
              {query ? (
                <Text style={styles.count}>
                  {results.length} of {apps.length}
                </Text>
              ) : null}
            </View>

            <AnimatedFlatList
              data={results}
              keyExtractor={(app) => app.packageName}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={{ paddingBottom: footerHeight + 32 }}
              scrollEventThrottle={16}
              onScroll={onScroll}
              onLayout={(event) =>
                measure({ layout: event.nativeEvent.layout.height })
              }
              onContentSizeChange={(_width, height) =>
                measure({ content: height })
              }
              ListEmptyComponent={
                query ? <Text style={styles.muted}>No matches</Text> : null
              }
              renderItem={({ item }) => (
                <AppRow
                  name={item.name}
                  delay={0}
                  reduceMotion={reduceMotion}
                  onPress={() => launchApp(item.packageName)}
                />
              )}
            />
          </>
        ) : null}
      </Animated.View>

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
        {isDefault || searching ? null : (
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
        <View style={styles.searchButton}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={searching ? "Close search" : "Search apps"}
            hitSlop={16}
            onPress={searching ? closeSearch : openSearch}
          >
            <View>
              <Animated.Text
                style={[
                  styles.searchLabel,
                  {
                    opacity: search.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 0],
                    }),
                  },
                ]}
              >
                Search
              </Animated.Text>
              <Animated.Text
                style={[styles.searchLabel, styles.searchLabelSwap, { opacity: search }]}
              >
                Close
              </Animated.Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function AppRow({
  name,
  delay,
  reduceMotion,
  onPress,
}: {
  name: string;
  delay: number;
  reduceMotion: boolean;
  onPress: () => void;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: reduceMotion ? 0 : DURATION_VERY_SLOW,
      delay: reduceMotion ? 0 : delay,
      easing: EASE_SMOOTH_OUT,
      useNativeDriver: true,
    }).start();
    // Entrance runs once per row; re-filtering must not replay it.
  }, []);

  const opacity = Animated.multiply(
    enter,
    press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
  );

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
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
            opacity,
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
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
      </Animated.View>
    </Pressable>
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

// Names that start with the query outrank names that merely contain it, so the
// first result stays the one the enter key should launch.
function rank(apps: InstalledApp[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return apps;
  }

  const starts: InstalledApp[] = [];
  const contains: InstalledApp[] = [];

  for (const app of apps) {
    const name = app.name.toLowerCase();
    if (name.startsWith(needle)) {
      starts.push(app);
    } else if (name.includes(needle)) {
      contains.push(app);
    }
  }

  return [...starts, ...contains];
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: BACKGROUND,
  },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  row: {
    paddingHorizontal: 28,
    paddingVertical: 13,
  },
  name: {
    color: "#F2F2F2",
    fontSize: 21,
    fontWeight: "300",
    letterSpacing: 0.2,
  },
  field: {
    paddingHorizontal: 28,
    paddingBottom: 20,
  },
  input: {
    padding: 0,
    color: "#F2F2F2",
    fontSize: 28,
    fontWeight: "300",
    letterSpacing: 0.2,
  },
  count: {
    marginTop: 8,
    color: "#5A5A5A",
    fontSize: 12,
    fontWeight: "300",
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
  // Bottom-right keeps the visible entry point inside the thumb's reach on a
  // large phone; the top corners are the hardest place to hit one-handed.
  searchButton: {
    alignSelf: "flex-end",
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchLabelSwap: {
    position: "absolute",
    top: 0,
    right: 0,
  },
  searchLabel: {
    color: "#8A8A8A",
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.4,
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
