import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Message } from '@/types';
import { getEmoji } from '@/services/emojiService';
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
        .select(`
          *
        `)
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



        // FIXME: refactor me...
        // Assuming messages have an array of reaction IDs
        if(!messages) return;
        for (const message of messages) {
          if (message.reactions && message.reactions.length > 0) {
            console.log(message);
            const { data: reactionDetails, error: reactionError } = await supabase
              .from('reactions')
              .select('*')
              .in('id', message.reactions);
  
            if (reactionError) {
              console.error('Error fetching reaction details:', reactionError);
              continue;
            }
  
            // Transforming each reaction detail to include emoji data
            for (const reaction of reactionDetails) {
              try {
                const emojiData = await getEmoji(reaction.emoji_id);
                reaction.emoji = emojiData;
              } catch (emojiError) {
                console.error('Error fetching emoji:', emojiError);
                reaction.emoji = null; // Or some default emoji
              }
            }
  
            // Attach the detailed reactions back to the message
            message.reactions = reactionDetails;
          }
        }

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
    // async sendReaction(messageId: string, emojiId: string, userId: string) {
    //   try {
    //     const { data, error } = await supabase
    //       .from('reactions')
    //       .insert([{ 
    //         message_id: messageId, 
    //         emoji_id: emojiId,
    //         user_id: userId,
    //       }])
    //       .select('*');
    
    //     if (error) {
    //       console.error('Error sending message:', error);
    //       return;
    //     }
    //     if (data && data.length > 0) {
    //       this.messages[messageId].reactions.push(data[0]);
    //     }
    //     console.log('Message sent:', data);
    //   } catch (e) {
    //     console.error('Error during message sending:', e);
    //   }
    // },
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
              reactions: payload.new.reactions,
              reply_to: payload.new.reply_to,
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
