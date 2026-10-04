/// <reference types="expo/types" />

// Static image imports. Metro resolves these to an asset reference; typing them
// lets screens `import` artwork rather than `require` it, which keeps the lint
// rule against CommonJS imports meaningful everywhere else.
//
// Kept here rather than in expo-env.d.ts: the Expo CLI owns that file and
// deletes or rewrites it when the dev server starts.
declare module '*.png' {
  const source: import('react-native').ImageSourcePropType;
  export default source;
}
declare module '*.ttf' {
  const source: number;
  export default source;
}
declare module '*.jpg' {
  const source: import('react-native').ImageSourcePropType;
  export default source;
}
