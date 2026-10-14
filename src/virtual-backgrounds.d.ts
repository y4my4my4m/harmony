declare module 'virtual:backgrounds' {
  /** Root-relative URLs of public/backgrounds/<folder> images, read at build time (vite-plugin-backgrounds.ts). */
  const backgrounds: {
    login: string[]
    notFound: string[]
  }
  export default backgrounds
}
