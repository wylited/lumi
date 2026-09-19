import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not builds.
  transpilePackages: ['@heli/ui', '@heli/tokens', '@heli/contracts'],
  webpack(webpackConfig) {
    // contracts import './x.js' from .ts sources (NodeNext style).
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }
    return webpackConfig
  },
  /**
   * The APK is a file to save, not a page to render. Without the explicit type
   * and disposition a phone browser is free to show a blank tab while it decides
   * what the bytes are, which reads as "the site is broken".
   */
  async headers() {
    return [
      {
        source: '/downloads/:file*.apk',
        headers: [
          { key: 'content-type', value: 'application/vnd.android.package-archive' },
          { key: 'content-disposition', value: 'attachment' },
        ],
      },
    ]
  },
}

export default config
