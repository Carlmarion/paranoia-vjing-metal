const RESTRICTED_PATHS = ['src/components/', 'src/features/']

const FORBIDDEN_GLOBALS = new Set(['fetch', 'localStorage', 'sessionStorage'])

const FORBIDDEN_MODULES = new Set(['axios'])

function isRestrictedPath(filename) {
  return RESTRICTED_PATHS.some((p) => filename.includes(p))
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct fetch/axios/localStorage calls in components and features. Use hooks or services instead.',
    },
    messages: {
      noDirectFetch:
        "Direct '{{name}}' call detected in {{dir}}. Move data access to a hook or service module in src/hooks/ or src/services/.",
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename || context.getFilename()
    if (!isRestrictedPath(filename)) return {}

    const dir =
      RESTRICTED_PATHS.find((p) => filename.includes(p)) || 'this directory'

    return {
      // Catches: fetch(...), localStorage.getItem(...), sessionStorage.setItem(...)
      CallExpression(node) {
        // Direct call: fetch(...)
        if (
          node.callee.type === 'Identifier' &&
          FORBIDDEN_GLOBALS.has(node.callee.name)
        ) {
          context.report({
            node,
            messageId: 'noDirectFetch',
            data: { name: node.callee.name, dir },
          })
        }

        // Member call: localStorage.getItem(...), axios.get(...)
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier'
        ) {
          const objName = node.callee.object.name
          if (FORBIDDEN_GLOBALS.has(objName)) {
            context.report({
              node,
              messageId: 'noDirectFetch',
              data: { name: objName, dir },
            })
          }
        }
      },

      // Catches: import axios from 'axios'
      ImportDeclaration(node) {
        if (FORBIDDEN_MODULES.has(node.source.value)) {
          context.report({
            node,
            messageId: 'noDirectFetch',
            data: { name: node.source.value, dir },
          })
        }
      },

      // Catches: const axios = require('axios')
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.name === 'require' &&
          node.init.arguments.length > 0 &&
          node.init.arguments[0].type === 'Literal' &&
          FORBIDDEN_MODULES.has(node.init.arguments[0].value)
        ) {
          context.report({
            node,
            messageId: 'noDirectFetch',
            data: { name: node.init.arguments[0].value, dir },
          })
        }
      },

      // Catches: window.fetch(...), window.localStorage.getItem(...)
      // Note: window.X produces a MemberExpression callee, not an Identifier,
      // so the CallExpression visitor above won't double-fire on these.
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'window' &&
          node.property.type === 'Identifier' &&
          FORBIDDEN_GLOBALS.has(node.property.name) &&
          node.parent.type === 'CallExpression'
        ) {
          context.report({
            node: node.parent,
            messageId: 'noDirectFetch',
            data: { name: `window.${node.property.name}`, dir },
          })
        }
      },
    }
  },
}
