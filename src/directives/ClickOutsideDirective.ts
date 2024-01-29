import type { Directive } from 'vue';

const ClickOutsideDirective: Directive = {
  beforeMount(el, binding) {
    el.clickOutsideEvent = function(event: Event) {
      // Check if click was outside the element
      if (!(el === event.target || el.contains(event.target as Node))) {
        // Call the provided method
        binding.value(event);
      }
    };
    // Listen for clicks outside the element
    document.addEventListener('click', el.clickOutsideEvent);
  },
  unmounted(el) {
    // Remove the event listener when the element is removed
    document.removeEventListener('click', el.clickOutsideEvent);
  },
};

export default ClickOutsideDirective;