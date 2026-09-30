import type { Directive } from 'vue';

// Also closes on a right-click elsewhere and on Escape, so opening one menu
// dismisses another. contextmenu is captured: menu triggers stop its
// propagation, and the capture phase runs before the next menu mounts.
const ClickOutsideDirective: Directive = {
  beforeMount(el, binding) {
    el.clickOutsideEvent = function(event: Event) {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value(event);
      }
    };
    el.clickOutsideKeydown = function(event: KeyboardEvent) {
      if (event.key === 'Escape') binding.value(event);
    };
    document.addEventListener('click', el.clickOutsideEvent);
    document.addEventListener('contextmenu', el.clickOutsideEvent, true);
    document.addEventListener('keydown', el.clickOutsideKeydown);
  },
  unmounted(el) {
    document.removeEventListener('click', el.clickOutsideEvent);
    document.removeEventListener('contextmenu', el.clickOutsideEvent, true);
    document.removeEventListener('keydown', el.clickOutsideKeydown);
  },
};

export default ClickOutsideDirective;
