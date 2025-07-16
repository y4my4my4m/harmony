import DefaultTheme from 'vitepress/theme'
import './custom.css'
import { h } from 'vue'

export default {
  ...DefaultTheme,
  Layout: () => {
    return h(DefaultTheme.Layout, null, {
      // Custom layout enhancements if needed
    })
  },
  enhanceApp({ app, router, siteData }) {
    // Global components registration
    // app.component('CustomComponent', CustomComponent)
    
    // Global properties
    // app.config.globalProperties.$customProperty = 'value'
  }
}
