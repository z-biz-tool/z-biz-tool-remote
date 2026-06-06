package com.zifang.teamviewer.common.packet;

import lombok.Data;

import static com.zifang.teamviewer.common.interfaces.Command.*;

@Data
public class LoginRequestPacket extends Packet {

    private String userId;

    private String username;

    private String password;

    @Override
    public Byte getCommand() {

        return LOGIN_REQUEST;
    }
}
