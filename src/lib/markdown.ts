import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import Prism from 'prismjs';
import 'prismjs/components/prism-dart';

const marked = new Marked(
  markedHighlight({
    langPrefix: 'language-',
    highlight(code: string, lang: string) {
      const language = lang || 'dart';
      const grammar = Prism.languages[language] || Prism.languages.dart;
      if (grammar) {
        try {
          return Prism.highlight(code, grammar, language);
        } catch (e) {
          void e;
        }
      }
      return code;
    },
  })
);

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}