package com.zifang.teamviewer.client;

import com.zifang.teamviewer.common.endecoder.*;
import com.zifang.teamviewer.common.handler.*;
import com.zifang.teamviewer.common.packet.ControlRequestPacket;
import com.zifang.teamviewer.common.packet.LoginRequestPacket;
import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.ChannelOption;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import io.netty.handler.codec.LengthFieldBasedFrameDecoder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Scanner;

public class NettyClient {

    private static final Logger logger = LoggerFactory.getLogger(NettyClient.class);
    private int MAX_RETRY = 5;
    private String host = "localhost";
    private int port = 8000;

    private Channel channel;

    public NettyClient(){
        NioEventLoopGroup workerGroup = new NioEventLoopGroup();

        Bootstrap bootstrap = new Bootstrap();
        bootstrap
                .group(workerGroup)
                .channel(NioSocketChannel.class)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5000)
                .option(ChannelOption.SO_KEEPALIVE, true)
                .option(ChannelOption.TCP_NODELAY, true)
                .handler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    public void initChannel(SocketChannel ch) {
                        ch.pipeline().addLast(new FirstClientHandler());
                        //ch.pipeline().addLast(new LengthFieldBasedFrameDecoder(Integer.MAX_VALUE, 7, 4));
//                        ch.pipeline().addLast(new PacketDecoder());
//                        ch.pipeline().addLast(new LoginResponseHandler());
//                        ch.pipeline().addLast(new MessageResponseHandler());
//                        ch.pipeline().addLast(new ImageResponseHandler());
//                        ch.pipeline().addLast(new ControlResponseHandler());
                        ch.pipeline().addLast(new PacketEncoder());
                    }
                });
        ChannelFuture future = null;
        try {
            future = bootstrap.connect(host, port).sync();
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
        if(future.isSuccess()){
            channel = future.channel();
        }
    }

    public void login(String userName,String password){
        LoginRequestPacket loginRequestPacket = new LoginRequestPacket();
        loginRequestPacket.setUserId(userName);
        loginRequestPacket.setPassword(password);
        loginRequestPacket.setUsername(userName);
        channel.writeAndFlush(loginRequestPacket);
    }

    public void control(String controllId){
        ControlRequestPacket controlRequestPacket = new ControlRequestPacket();
        controlRequestPacket.setUserTo(controllId);
        controlRequestPacket.setUserId(controllId);
        channel.writeAndFlush(controlRequestPacket);
//        ImageRequestPacket imageRequestPacket = new ImageRequestPacket();
//        imageRequestPacket.setControllerId(controllId);

        //channel.writeAndFlush(controlRequestPacket);
    }

    public void message(){
//        //message u3 aaaaa
//        String userTo = line.split(" ")[1];
//        String message = line.split(" ")[2];
//
//        MessageRequestPacket messageRequestPacket = new MessageRequestPacket(message);
//        messageRequestPacket.setUserTo(userTo);
//
//        channel.writeAndFlush(messageRequestPacket);
    }

    public Channel getChannel() {
        return channel;
    }



}
