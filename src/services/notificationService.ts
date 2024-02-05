import { supabase } from '@/supabase';

export const subscribeToServerNotifications = async (userId: string, serverId: string) => {
    // subscribe from notification events in server
    const channel = supabase.channel(`notificationsFromServer-${serverId}`, {
        config: {
            broadcast: { self: true },
        },
    }).subscribe();

    channel.on('broadcast', { event: 'mention' }, (payload) => {
        console.log("received broadcast in server");
        console.log(payload);
    });
}


export const unsubscribeToServerNotifications = async (userId: string, serverId: string) => {
    // unsubscribe from notification events in server
    supabase.channel(`notificationsFromServer-${serverId}`, {
        config: {
            broadcast: { self: true },
        },
    }).unsubscribe();
}

export const broadcastInServer = async (event: string, serverId: string, to?: string, from?: string, content?: string, messageId?: string) => {
    // broadcast notification to server listeners
    const channel = supabase.channel(`notificationsFromServer-${serverId}`);

    channel.send({
        type: 'broadcast',
        event,
        payload: {
            serverId,
            to,
            from,
            content,
            messageId
        }
    });
}

export const listenInServer = async (event: string, serverId: string) => {
    // listen to broadcast notifications for server
    const channel = supabase.channel(`notificationsFromServer-${serverId}`);
    // , from?: string, content?: string, messageId?: string
    // console.log(from, content, messageId);

    channel.on('broadcast', { event }, (payload) => {
        console.log("received broadcast in server");
        console.log(payload);
        // const { event, userId } = payload.payload;

        // if (event === 'user-joined') {
        //     // console.log(channel,event);
        //     if (!this.usersInVoiceChannels[channelId]) {
        //     this.usersInVoiceChannels[channelId] = [];
        //     }
        //     if (!this.usersInVoiceChannels[channelId].includes(userId)) {
        //     this.usersInVoiceChannels[channelId].push(userId);
        //     }
        // } else if (event === 'user-left') {
        //     this.usersInVoiceChannels[channelId] = this.usersInVoiceChannels[channelId].filter(id => id !== userId);
        // }
        // console.log(this.usersInVoiceChannels[channelId]);
    })
}