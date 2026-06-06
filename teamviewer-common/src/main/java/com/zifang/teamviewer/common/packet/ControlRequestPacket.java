package com.zifang.teamviewer.common.packet;


import static com.zifang.teamviewer.common.interfaces.Command.*;

public class ControlRequestPacket extends Packet {
    private String userTo;
    private String userId;

    private String username;

    public String getUserTo() {
        return userTo;
    }

    public void setUserTo(String userTo) {
        this.userTo = userTo;
    }

    private String password;

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    @Override
    public Byte getCommand() {

        return CONTROL_REQUEST;
    }

    public Byte getVersion(){
        return version;
    }
}
