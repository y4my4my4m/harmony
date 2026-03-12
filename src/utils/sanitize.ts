const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

const escapeRegex = /[&<>"']/g;

export function escapeHtml(text: string): string {
  return text.replace(escapeRegex, (char) => escapeMap[char]);
}
