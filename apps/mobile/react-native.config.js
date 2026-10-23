/* global module, process */
// Android retains Expo's existing FCM implementation. Only a configured iOS
// build links RNFirebase; credential-free simulator builds keep their baseline.
const ios = process.env.GOOGLE_SERVICE_INFO_PLIST?.trim() ? {} : { ios: null };
module.exports = {
  dependencies: {
    '@react-native-firebase/app': { platforms: { android: null, ...ios } },
    '@react-native-firebase/messaging': { platforms: { android: null, ...ios } },
  },
};
