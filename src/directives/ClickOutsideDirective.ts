import type { Directive } from 'vue';

const ClickOutsideDirective: Directive = {
  beforeMount(el, binding) {
    el.clickOutsideEvent = function(event: Event) {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value(event);
      }
    };
    // Listen for clicks outside the element
    document.addEventListener('click', el.clickOutsideEvent);
  },
  unmounted(el) {
    document.removeEventListener('click', el.clickOutsideEvent);
  },
};

export default ClickOutsideDirective;