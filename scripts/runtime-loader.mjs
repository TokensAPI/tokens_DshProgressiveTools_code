import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Test the compiled plugin against a host's complete installed dependency graph.
if (process.env.DSH_TEST_RUNTIME) {
  const parentURL = pathToFileURL(resolve(process.env.DSH_TEST_RUNTIME, 'package.json')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/')) {
        return nextResolve(specifier, { ...context, parentURL })
      }
      return nextResolve(specifier, context)
    },
  })
}
