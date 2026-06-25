import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.gwaves.novelreader.gateway',
  appName: 'Novel Gateway',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
}

export default config
