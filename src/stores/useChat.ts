import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Message } from '@/types';

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as Message[],
    currentSubscription: null as any | null,
    loadingOlderMessages: false,
    allMessagesLoaded: false,
  }),
  actions: {
    clearMessages() {
      this.messages = [];
      this.allMessagesLoaded = false;
    },
    async fetchMessages(channelId: number, oldestMessageId: number = 0) {
      if (this.loadingOlderMessages && oldestMessageId !== 0) return;
      this.loadingOlderMessages = true;
      let query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (oldestMessageId !== 0) {
        query = query.lt('id', oldestMessageId);
      }

      const { data: messages, error } = await query;

      if (error) {
        console.error('Error fetching messages:', error);
      } else {
        if (messages.length < 20) {
          this.allMessagesLoaded = true;
        }
        if (oldestMessageId === 0) {
          this.messages = messages.reverse();
        } else {
          this.messages = [...messages.reverse(), ...this.messages];
        }
      }
      this.loadingOlderMessages = false;
    },
    async sendMessage(channelId: number, userId: string, content: string, file_url?: string) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .insert([{ channel_id: channelId, user_id: userId, content: content, file_url: file_url }])
          .select('*');
    
        if (error) {
          console.error('Error sending message:', error);
          return;
        }
        if (data && data.length > 0) {
          this.messages.push(data[0]);
        }
        console.log('Message sent:', data);
      } catch (e) {
        console.error('Error during message sending:', e);
      }
    },    
    subscribeToMessages(channelId: number) {
      
      if (this.currentSubscription) {
        this.currentSubscription.unsubscribe();
      }

      const channelName = `channel-${channelId}`;
      this.currentSubscription = supabase
        .channel(channelName)
        .on(
          'postgres_changes', 
          { event: 'INSERT', schema: 'public', table: 'messages'},
          (payload) => {
            // console.log(payload);
            const newMessage: Message = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at),
              channel_id: payload.new.channel_id,
              user_id: payload.new.user_id,
              content: payload.new.content,
              file_url: payload.new.file_url,
            };

            if (!this.messages.some(msg => msg.id === newMessage.id)) {
              this.messages.push(newMessage);
            }
          }
        )
        .subscribe();
    }
  },
});
