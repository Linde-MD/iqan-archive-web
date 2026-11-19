declare module 'markdown-it-ins' {
  import type MarkdownIt from 'markdown-it';
  const ins: (markdown: MarkdownIt) => void;
  export default ins;
}
