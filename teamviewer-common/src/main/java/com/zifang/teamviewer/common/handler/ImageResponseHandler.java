package com.zifang.teamviewer.common.handler;

import com.zifang.teamviewer.common.packet.ImageResponsePacket;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;

import javax.swing.*;
import java.awt.*;

public class ImageResponseHandler extends SimpleChannelInboundHandler<ImageResponsePacket> {

    public static Frame frame =null;

    @Override
    protected void channelRead0(ChannelHandlerContext channelHandlerContext, ImageResponsePacket imageResponsePacket) throws Exception {

        if(frame == null){
            frame = new Frame();
        }
        byte[] bufferedImage = imageResponsePacket.getBufferedImage();
        frame.refresh(bufferedImage);
    }
}

class Frame {
    JFrame jFrame = new JFrame();
    JPanel jp = new JPanel();
    JLabel jLabel = new JLabel();

    Frame(){
        jp.add(jLabel);
        jFrame.add(jp);
        jFrame.setSize(new Dimension(500,500));
        jFrame.setVisible(true);
        jFrame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
    }
    public void refresh(byte[] bufferedImage){
        jLabel.setIcon(new ImageIcon(bufferedImage));
        jFrame.validate();
        jFrame.repaint();
    }
}
