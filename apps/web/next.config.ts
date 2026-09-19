import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not builds.
  transpilePackages: ['@heli/ui', '@heli/tokens', '@heli/contracts', '@heli/fixtures'],
  webpack(webpackConfig) {
    // contracts and fixtures import './x.js' from .ts sources (NodeNext style).
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }
    return webpackConfig
  },
}

export default config
