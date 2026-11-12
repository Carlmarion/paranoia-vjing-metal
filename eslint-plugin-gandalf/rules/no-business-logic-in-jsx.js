export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow complex business logic inside JSX. Extract to variables, functions, or hooks.',
    },
    messages: {
      noNestedTernary:
        'Nested ternary in JSX. Extract to a variable or function above the return statement.',
      noLongLogicalChain:
        'Complex logical chain in JSX ({{count}} conditions). Extract to a variable above the return statement.',
      noInlineFunction:
        'Multi-line inline function in JSX. Extract to a named function or hook.',
    },
    schema: [],
  },

  create(context) {
    let jsxDepth = 0

    return {
      JSXElement() {
        jsxDepth++
      },
      'JSXElement:exit'() {
        jsxDepth--
      },
      JSXFragment() {
        jsxDepth++
      },
      'JSXFragment:exit'() {
        jsxDepth--
      },

      // Nested ternaries inside JSX
      ConditionalExpression(node) {
        if (jsxDepth === 0) return

        if (
          node.parent.type === 'ConditionalExpression' ||
          hasNestedTernary(node.consequent) ||
          hasNestedTernary(node.alternate)
        ) {
          context.report({ node, messageId: 'noNestedTernary' })
        }
      },

      // Long logical chains: a && b && c && d (>3 operands)
      LogicalExpression(node) {
        if (jsxDepth === 0) return

        // Only report on the outermost logical expression
        if (node.parent.type === 'LogicalExpression') return

        const count = countLogicalOperands(node)
        if (count > 3) {
          context.report({
            node,
            messageId: 'noLongLogicalChain',
            data: { count: String(count) },
          })
        }
      },

      // Multi-line arrow functions as JSX props
      JSXExpressionContainer(node) {
        if (
          node.expression.type === 'ArrowFunctionExpression' &&
          node.expression.body.type === 'BlockStatement' &&
          node.expression.body.body.length > 1
        ) {
          context.report({
            node: node.expression,
            messageId: 'noInlineFunction',
          })
        }
      },
    }

    function hasNestedTernary(node) {
      return node && node.type === 'ConditionalExpression'
    }

    function countLogicalOperands(node) {
      if (node.type !== 'LogicalExpression') return 1
      return countLogicalOperands(node.left) + countLogicalOperands(node.right)
    }
  },
}
