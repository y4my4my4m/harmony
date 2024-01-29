<template>
    <div class="categoryCreatorOverlay"  @click="closeCategoryCreator">
      <div class="categoryCreator"  @click.stop>
        <input 
          type="text" 
          placeholder="New Category"
          class="categoryInput"
          ref="categoryInput"
        />
        <div class="btn create" @click="handleCreation">Create</div>
    </div>
</div>
</template>
  
<script lang="ts">
  import { defineComponent, ref, onMounted, onUnmounted } from 'vue';

  export default defineComponent({
    setup(_, { emit }) {
      const categoryInput = ref<HTMLInputElement | null>(null);

      const closeCategoryCreator = () => {
        emit('showCategoryCreator', false); 
      };

      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeCategoryCreator();
        }
        if (event.key === 'Return') {
          handleCreation();
        }
      };

      const handleCreation = () => {
        const category = categoryInput.value?.value;
        if (category) {
          emit('createCategory', category);
          closeCategoryCreator();
        }
      };
  
      onMounted(async () => {
        window.addEventListener('keydown', onKeydown);
        categoryInput.value?.focus();
      });

      onUnmounted(() => {
        window.removeEventListener('keydown', onKeydown);
      });

      return { 
        categoryInput,
        closeCategoryCreator,
        handleCreation,
      };
    },
  });
</script>
  
<style scoped>
  .categoryCreatorOverlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index:10;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: rgba(0, 0, 0, 0.6);
  }
  
  .categoryCreator {
    background-color: #ffffff;
    width: 80%;
    max-width: 600px;
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  
  .categoryInput {
    width: 100%;
    padding: 10px;
    margin-bottom: 20px;
    border-radius: 5px;
    border: 1px solid #ccc;
  }
  
  
  .btn {
    padding: 10px 15px;
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    background-color: #5865f2; 
    transition: background-color 0.2s;
  }
  .btn:hover {
    opacity: 0.8;
  }

  .create {
    background-color: #43b581;
    width:auto;
    display:inline-flex;
    float:right;
  }

  </style>
  