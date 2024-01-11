import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { ChatMessage } from '@/types';  // Define Message type according to your schema

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as ChatMessage[],
  }),
  actions: {
    async fetchMessages(channelId: number) {
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) console.error('Error fetching messages:', error);
      else this.messages = messages.reverse();  // Reverse to display in correct order
    },
    async sendMessage(channelId: number, userId: string, content: string) {
      const { data, error } = await supabase
        .from('messages')
        .insert([
          { channel_id: channelId, user_id: userId, content: content }
        ]);
    
      if (error) {
        console.error('Error sending message:', error);
      } else {
        console.log('Message sent:', data);
      }
    },
    subscribeToMessages(channelId: number) {
      const channelName = `channel-${channelId}`;
    
      supabase
        .channel(channelName)
        .on(
          'postgres_changes', 
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `eq.channel_id.${channelId}` },
          (payload) => {
            // Map payload to ChatMessage type if necessary
            const newMessage: ChatMessage = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at), // Example, adjust according to your payload
              channel_id: payload.new.channel_id,
              user_id: payload.new.user_id,
              content: payload.new.content,
            };
    
            this.messages.unshift(newMessage);
          }
        )
        .subscribe();
    }
    
    
    
  },
});
