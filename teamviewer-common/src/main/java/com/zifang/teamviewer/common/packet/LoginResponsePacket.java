package com.zifang.teamviewer.common.packet;


import static com.zifang.teamviewer.common.interfaces.Command.*;

public class LoginResponsePacket extends Packet {
    private boolean success;

    private String reason;


    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public String getReason() {
        return reason;
    }

    public void setReason(String reason) {
        this.reason = reason;
    }

    @Override
    public Byte getCommand() {
        return LOGIN_RESPONSE;
    }

    public void setVersion(Byte version){
        this.version = version;
    }
}
