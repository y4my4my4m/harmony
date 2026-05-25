module.exports = {
  outDir: "docs/generated/components",
  components: "src/components/**/*.vue",
  outFile: "components.json",
  apiOptions: {
    jsx: false
  },
  getComponentName: "componentName"
}
