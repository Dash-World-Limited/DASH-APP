import { registerRootComponent } from 'expo';

import HomePreviewApp from './src/v2/home/HomePreviewApp';

// UI review branch only: boot the isolated Customer Home preview so it can be
// inspected locally in VS Code/Expo without changing the production app tree.
registerRootComponent(HomePreviewApp);
