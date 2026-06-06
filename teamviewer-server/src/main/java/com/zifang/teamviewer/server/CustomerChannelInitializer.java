package com.zifang.teamviewer.server;

import com.zifang.teamviewer.common.endecoder.*;
import com.zifang.teamviewer.common.handler.*;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.socket.nio.NioSocketChannel;
import io.netty.handler.codec.LengthFieldBasedFrameDecoder;

/**
 * 自定义的链路解析初始化类
 * */
public class CustomerChannelInitializer extends ChannelInitializer<NioSocketChannel> {
    @Override
    protected void initChannel(NioSocketChannel ch){
        //ch.pipeline().addLast(new LengthFieldBasedFrameDecoder(Integer.MAX_VALUE, 7, 4));
        ch.pipeline().addLast(new PacketDecoder());
        ch.pipeline().addLast(new LoginRequestHandler());
//        ch.pipeline().addLast(new MessageRequestHandler());
//        ch.pipeline().addLast(new ImageRequestHandler());
//        ch.pipeline().addLast(new ControlRequestHandler());
//        ch.pipeline().addLast(new PacketEncoder());
        ch.pipeline().addLast(new FirstServerHandler());
    }
}
