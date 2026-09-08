import { useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  Easing,
  FlatList,
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

import LauncherModule, { type InstalledApp } from "./modules/launcher";

const BACKGROUND = "#000000";
const TOP_FADE = 56;
const BOTTOM_FADE = 80;
const STAGGER_MS = 28;
const MAX_STAGGERED = 14;

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

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  function launchApp(packageName: string) {
    LauncherModule.launchApp(packageName).catch(showError);
  }

  const footerHeight = insets.bottom + (isDefault ? 24 : 76);

  return (
    <View style={styles.screen}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="light-content"
      />

      <FlatList
        data={apps}
        keyExtractor={(app) => app.packageName}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 40,
          paddingBottom: footerHeight + 32,
        }}
        ListEmptyComponent={<Text style={styles.empty}>No apps yet</Text>}
        renderItem={({ item, index }) => (
          <AppRow
            name={item.name}
            index={index}
            onPress={() => launchApp(item.packageName)}
          />
        )}
      />

      <LinearGradient
        pointerEvents="none"
        colors={[BACKGROUND, BACKGROUND, "transparent"]}
        locations={[0, insets.top / (insets.top + TOP_FADE), 1]}
        style={[styles.fade, { top: 0, height: insets.top + TOP_FADE }]}
      />
      <LinearGradient
        pointerEvents="none"
        colors={["transparent", BACKGROUND, BACKGROUND]}
        locations={[0, BOTTOM_FADE / (insets.bottom + BOTTOM_FADE), 1]}
        style={[styles.fade, { bottom: 0, height: insets.bottom + BOTTOM_FADE }]}
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
  index,
  onPress,
}: {
  name: string;
  index: number;
  onPress: () => void;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 420,
      delay: Math.min(index, MAX_STAGGERED) * STAGGER_MS,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: true,
    }).start();
  }, [enter, index]);

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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: BACKGROUND,
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
  empty: {
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
    paddingHorizontal: 24,
    alignItems: "center",
  },
  error: {
    marginBottom: 12,
    textAlign: "center",
    color: "#FF6B6B",
    fontSize: 13,
  },
});
