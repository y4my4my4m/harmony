<template>
  <div v-if="show" class="modal-overlay" @click="closeForm">
    <div class="modal-content" @click.stop>
      <h2 class="card-header">Create a New Channel</h2>
      
      <form @submit.prevent="createChannel" class="form">
        <div class="form-group">
          <label class="form-label">Channel Name</label>
          <input 
            type="text" 
            v-model="newChannelName" 
            placeholder="Enter channel name" 
            class="input-base"
            required 
          />
        </div>
        
        <div class="form-group">
          <label class="form-label">Channel Type</label>
          <div class="channel-type-buttons">
            <button 
              type="button"
              @click="setChannelType(0)" 
              :class="['btn', channelType === 0 ? 'btn-primary' : 'btn-secondary']"
            >
              # Text
            </button>
            <button 
              type="button"
              @click="setChannelType(1)" 
              :class="['btn', channelType === 1 ? 'btn-primary' : 'btn-secondary']"
            >
              🔊 Voice
            </button>
          </div>
        </div>
        
        <div class="form-actions">
          <button type="submit" class="btn btn-success">Create Channel</button>
          <button type="button" @click="closeForm" class="btn btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>
 
<script lang="ts">
import { defineComponent, ref } from 'vue'
import { useKeyboardEvents } from '@/composables/useCommonUI'
import { supabase } from '@/supabase'

export default defineComponent({
  name: 'CreateChannel',
  props: {
    serverId: {
      type: String,
      required: true
    },
    show: {
      type: Boolean,
      required: true
    },
    categoryId: {
      type: String,
      default: null
    }
  },
  emits: ['close', 'channelCreated'],
  setup(props, { emit }) {
    const newChannelName = ref('')
    const channelType = ref(0) // Default to text channel
    const { handleEscapeKey } = useKeyboardEvents()

    const setChannelType = (type: number) => {
      channelType.value = type
    }

    const createChannel = async () => {
      if (!newChannelName.value.trim()) return

      try {
        const { data, error } = await supabase
          .from('channels')
          .insert([{ 
            name: newChannelName.value.trim(), 
            server_id: props.serverId, 
            type: channelType.value, 
            category: props.categoryId 
          }])
          .select('*')
          .single()

        if (error) throw error
        
        emit('channelCreated', data)
        closeForm()
      } catch (error) {
        console.error('Error creating channel:', error)
      }
    }

    const closeForm = () => {
      newChannelName.value = ''
      channelType.value = 0
      emit('close')
    }

    // Handle escape key to close
    handleEscapeKey(closeForm)

    return { 
      newChannelName, 
      channelType, 
      setChannelType, 
      createChannel, 
      closeForm 
    }
  },
})
</script>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.channel-type-buttons {
  display: flex;
  gap: 12px;
}

.channel-type-buttons .btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 8px;
}

.form-actions .btn {
  min-width: 100px;
}
</style>
