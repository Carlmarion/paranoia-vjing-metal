export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow useEffect that only derives state from props/state. Use useMemo or compute inline instead.',
    },
    messages: {
      noUseEffectDerived:
        'useEffect used to derive state. Compute this value inline or use useMemo instead. See: https://react.dev/learn/you-might-not-need-an-effect',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match useEffect(callback, deps)
        if (
          node.callee.type !== 'Identifier' ||
          node.callee.name !== 'useEffect'
        ) {
          return
        }

        // Must have a callback and a dependency array
        if (node.arguments.length < 2) return

        const callback = node.arguments[0]
        if (
          callback.type !== 'ArrowFunctionExpression' &&
          callback.type !== 'FunctionExpression'
        ) {
          return
        }

        const body = callback.body

        // Handle arrow function with expression body: useEffect(() => setX(y), [y])
        if (body.type !== 'BlockStatement') {
          if (isDerivedSetterCall(body)) {
            context.report({ node, messageId: 'noUseEffectDerived' })
          }
          return
        }

        // Block body: must contain only derived setter calls (1 or more, nothing else)
        const statements = body.body.filter(
          (s) => s.type !== 'EmptyStatement',
        )
        if (statements.length === 0) return

        const allDerivedSetters = statements.every(
          (s) =>
            s.type === 'ExpressionStatement' &&
            isDerivedSetterCall(s.expression),
        )

        if (allDerivedSetters) {
          context.report({ node, messageId: 'noUseEffectDerived' })
        }
      },
    }

    // Detects setState/setX calls with non-literal arguments.
    // Convention: function name starts with "set" followed by uppercase.
    //
    // Flags: setCount(items.length), setName(firstName + lastName)
    // Ignores: setError(null), setLoading(true), setCount(0)
    //
    // Rationale: setters with literal args are "reset on change" patterns,
    // which are a valid useEffect use case. Setters with derived expressions
    // should be useMemo or computed inline.
    function isDerivedSetterCall(node) {
      if (
        node.type !== 'CallExpression' ||
        node.callee.type !== 'Identifier' ||
        !/^set[A-Z]/.test(node.callee.name)
      ) {
        return false
      }

      // No args or literal value (null, 0, '', false, true) = reset pattern, not derived
      if (node.arguments.length === 0) return false
      const arg = node.arguments[0]
      if (arg.type === 'Literal' || arg.type === 'TemplateLiteral')
        return false

      return true
    }
  },
}
