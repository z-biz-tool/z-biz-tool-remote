package com.zifang.teamviewer.client;

import com.zifang.teamviewer.common.packet.ControlRequestPacket;
import com.zifang.teamviewer.common.packet.LoginRequestPacket;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.Charset;


public class NettyClientExecutor {

    private static final Logger logger = LoggerFactory.getLogger(NettyClientExecutor.class);

    private NettyClient nettyClient;

    public NettyClientExecutor(NettyClient nettyClient) {
        this.nettyClient = nettyClient;
    }

    public void printOriginalHint() {
        System.out.println("开始操作---------");
        System.out.println("登录一下 指令格式 \"login:aa:bb\"");

    }

    public String exec(String command) {
        if(command.startsWith("login:")){
            String sub = command.split("login:")[1];
            login(sub.split(":")[0],sub.split(":")[1]); // 调用登录的操作
            logger.info("得到的登录参数为："+sub);
        }
        return "";
    }

    public void login(String userName,String password){
//        // 1. 获取二进制抽象 ByteBuf
//        ByteBuf buffer = Unpooled.buffer(10);
//
//        // 2. 准备数据，指定字符串的字符集为 utf-8
//        byte[] bytes = "你好，闪电侠!".getBytes(Charset.forName("utf-8"));
//
//        // 3. 填充数据到 ByteBuf
//        buffer.writeBytes(bytes);
//        nettyClient.getChannel().writeAndFlush(buffer);

        LoginRequestPacket loginRequestPacket = new LoginRequestPacket();
        loginRequestPacket.setUserId("aa");
        loginRequestPacket.setPassword("bb");
        loginRequestPacket.setUsername("cc");
        nettyClient.getChannel().writeAndFlush(loginRequestPacket);
    }

    public void control(String controllId){
        ControlRequestPacket controlRequestPacket = new ControlRequestPacket();
        controlRequestPacket.setUserTo(controllId);
        controlRequestPacket.setUserId(controllId);
        nettyClient.getChannel().writeAndFlush(controlRequestPacket);
//        ImageRequestPacket imageRequestPacket = new ImageRequestPacket();
//        imageRequestPacket.setControllerId(controllId);

        //channel.writeAndFlush(controlRequestPacket);
    }
}
