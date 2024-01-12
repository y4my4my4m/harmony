import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { ChatMessage } from '@/types';  // Define Message type according to your schema

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as ChatMessage[],
  }),
  actions: {
    clearMessages() {
      this.messages = [];
    },
    async fetchMessages(channelId: number) {
      console.log("AAAA");
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) console.error('Error fetching messages:', error);
      else this.messages = messages.reverse();  // Reverse to display in correct order
      console.log("Updated messages in store:", this.messages);
    },
    async sendMessage(channelId: number, userId: string, content: string) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .insert([{ channel_id: channelId, user_id: userId, content: content }]);
          // .select('*');
    
        if (error) {
          console.error('Error sending message:', error);
          return;
        }
    
        console.log('Message sent:', data);
      } catch (e) {
        console.error('Error during message sending:', e);
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
            const newMessage: ChatMessage = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at),
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
