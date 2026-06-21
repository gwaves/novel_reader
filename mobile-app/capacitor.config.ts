import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.gwaves.novelreader.mobile',
  appName: 'Novel Reader',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
