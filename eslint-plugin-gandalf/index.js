import noDirectFetch from './rules/no-direct-fetch.js'
import noUseeffectDerivedState from './rules/no-useeffect-derived-state.js'
import noBusinessLogicInJsx from './rules/no-business-logic-in-jsx.js'

const plugin = {
  meta: {
    name: 'eslint-plugin-gandalf',
    version: '1.0.0',
  },
  rules: {
    'no-direct-fetch': noDirectFetch,
    'no-useeffect-derived-state': noUseeffectDerivedState,
    'no-business-logic-in-jsx': noBusinessLogicInJsx,
  },
}

export default plugin
