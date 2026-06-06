package com.zifang.teamviewer.common.packet;

import static com.zifang.teamviewer.common.interfaces.Command.COMMON_REQUEST;

public class CommonRequestPacket extends Packet {



    @Override
    public Byte getCommand() {
        return COMMON_REQUEST;
    }
}
