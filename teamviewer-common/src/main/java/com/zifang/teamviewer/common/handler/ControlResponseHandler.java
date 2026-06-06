package com.zifang.teamviewer.common.handler;

import com.zifang.teamviewer.common.packet.ControlResponsePacket;
import com.zifang.teamviewer.common.packet.ImageRequestPacket;
import com.zifang.teamviewer.common.utils.Session;
import com.zifang.teamviewer.common.utils.SessionUtil;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

public class ControlResponseHandler extends SimpleChannelInboundHandler<ControlResponsePacket> {
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, ControlResponsePacket controlResponsePacket) {
        Session session = SessionUtil.getSession(ctx.channel());
        //发起control 的人

        //Channel fromChanel = SessionUtil.getChannel(controlResponsePacket.getUserId());

        Thread thread = new Thread(){
            @Override
            public void run(){
                while(true){
                    ImageRequestPacket imageRequestPacket = new ImageRequestPacket();
                    imageRequestPacket.setUserTo(controlResponsePacket.getUserId());
                    Robot robot = null;
                    try {
                        robot = new Robot();
                    } catch (AWTException e) {
                        e.printStackTrace();
                    }
                    //设置Robot产生一个动作后的休眠时间,否则执行过快
                    robot.setAutoDelay(1000);
                    //获取屏幕分辨率
                    Dimension d = Toolkit.getDefaultToolkit().getScreenSize();
                    System.out.println(d);
                    //以屏幕的尺寸创建个矩形
                    Rectangle screenRect = new Rectangle(d);
                    //截图（截取整个屏幕图片）
                    BufferedImage bufferedImage =  robot.createScreenCapture(screenRect);
                    //imageResponsePacket.setBufferedImage(bufferedImage);
//
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    try {
                        ImageIO.write(bufferedImage,"png",out);
                    } catch (IOException e) {
                        e.printStackTrace();
                    }
                    imageRequestPacket.setBufferedImage(out.toByteArray());
                    ctx.channel().writeAndFlush(imageRequestPacket);
                    try {
                        Thread.sleep(1);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }

            }
        };

        thread.start();
    }
}
