const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

/**
 * `@heli/contracts` ships TypeScript sources with NodeNext `.js` specifiers —
 * `./signal.js` is really `signal.ts`. Webpack does that rewrite on the web
 * (`apps/web`'s `extensionAlias`); Metro does not, so every `.js` specifier
 * inside a workspace package would fail to resolve. Strip it and let Metro's
 * normal resolution find the `.ts` beside it.
 */
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform)
    } catch {
      // Fall through to the standard resolution below.
    }
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
