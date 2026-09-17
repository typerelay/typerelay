import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
 appId: 'com.typerelay.mobile', appName: 'TypeRelay', webDir: 'dist',
 plugins: { CapacitorHttp: { enabled: true } },
 server: { androidScheme: 'https' },
};
export default config;
