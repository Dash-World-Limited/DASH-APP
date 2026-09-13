import { registerRootComponent } from 'expo';

import DashApp from './src/v2/App';

// A single React root owns the whole Customer/Rider experience. We deliberately
// do not boot Expo Router or react-native-screens here: role changes are plain
// state transitions and can never re-parent a native Fragment view.
registerRootComponent(DashApp);
