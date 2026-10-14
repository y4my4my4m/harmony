import backgrounds from 'virtual:backgrounds'

function pick(list: readonly string[]): string {
  return list.length ? list[Math.floor(Math.random() * list.length)] : ''
}

let login: string | undefined

/** URL of a public/backgrounds/login image, '' when the folder is empty. Fixed for the page load. */
export function loginBackground(): string {
  return (login ??= pick(backgrounds.login))
}

/** URL of a random public/backgrounds/404 image, '' when the folder is empty. */
export function randomNotFoundImage(): string {
  return pick(backgrounds.notFound)
}
