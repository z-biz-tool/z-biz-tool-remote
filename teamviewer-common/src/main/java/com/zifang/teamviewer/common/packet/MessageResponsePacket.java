package com.zifang.teamviewer.common.packet;


import lombok.Data;

import static com.zifang.teamviewer.common.interfaces.Command.MESSAGE_RESPONSE;

@Data
public class MessageResponsePacket extends Packet {

    private String message;

    @Override
    public Byte getCommand() {
        return MESSAGE_RESPONSE;
    }
}
