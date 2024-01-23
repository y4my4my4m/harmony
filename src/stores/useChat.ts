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
    async fetchMessages(channelId: string, oldestMessageId: string = '') {
      if (this.loadingOlderMessages && oldestMessageId !== '') return;
      this.loadingOlderMessages = true;
      const query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(20);

      // what was that for again?

      // if (oldestMessageId !== '') {
      //   const { data: oldestMessage } = await supabase
      //     .from('messages')
      //     .select('created_at')
      //     .eq('id', oldestMessageId)
      //     .single();

      //   if (oldestMessage) {
      //     query = query.lt('created_at', oldestMessage.created_at);
      //   }
      // }

      const { data: messages, error } = await query;

      if (error) {
        console.error('Error fetching messages:', error);
      } else {
        if (messages.length < 20) {
          this.allMessagesLoaded = true;
        }
        if (oldestMessageId === '') {
          this.messages = messages.reverse();
        } else {
          this.messages = [...messages.reverse(), ...this.messages];
        }
      }
      this.loadingOlderMessages = false;
    },
    async editMessage(messageId: string, content: string) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .update({ content: content })
          .match({ id: messageId })
          .select('*');
    
        if (error) {
          console.error('Error editing message:', error);
          return;
        }
        if (data && data.length > 0) {
          this.messages = this.messages.map((msg) => {
            if (msg.id === messageId) {
              return data[0];
            }
            return msg;
          });
        }
        console.log('Message edited:', data);
      } catch (e) {
        console.error('Error during message edition:', e);
      }
    },
    async deleteMessage(messageId: string) {
      try {
        const { error } = await supabase.from('messages').delete().match({ id: messageId });
        if (error) {
          console.error('Error deleting message:', error);
          return;
        }
        this.messages = this.messages.filter((msg) => msg.id !== messageId);
      } catch (e) {
        console.error('Error during message deletion:', e);
      }
    },
    async sendMessage(channelId: string, userId: string, content: Array<Object>) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .insert([{ 
            channel_id: channelId, 
            user_id: userId, 
            content: content,
          }])
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
    subscribeToMessages(channelId: string) {
      
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
