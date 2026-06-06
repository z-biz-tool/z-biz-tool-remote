package com.zifang.teamviewer.common.endecoder;

import com.zifang.teamviewer.common.packet.Packet;
import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.ByteToMessageDecoder;

import java.util.List;

/**
 * 全局性的解码器
 * */
public class PacketDecoder extends ByteToMessageDecoder {

    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in, List out) {
        Packet packet = PacketCodeC.INSTANCE.decode(in);
        out.add(packet);
    }
}
