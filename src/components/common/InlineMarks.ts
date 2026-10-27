import { h, type FunctionalComponent, type PropType, type VNode } from 'vue';
import type { InlineMark } from '@/utils/inlineMarkdownRuns';

/**
 * Draws the inline markdown elements open around a non-text message part
 * (utils/inlineMarkdownRuns) around its slot, outermost first. No marks: the slot alone.
 */
const InlineMarks: FunctionalComponent<{ marks?: readonly InlineMark[] }> = (props, { slots }) => {
  let children: VNode[] | undefined = slots.default?.();
  const marks = props.marks ?? [];
  for (let i = marks.length - 1; i >= 0; i--) {
    children = [h(marks[i].tag, { class: `md-mark ${marks[i].className}` }, children)];
  }
  return children;
};

InlineMarks.props = {
  marks: { type: Array as PropType<readonly InlineMark[]>, default: undefined },
};

export default InlineMarks;
