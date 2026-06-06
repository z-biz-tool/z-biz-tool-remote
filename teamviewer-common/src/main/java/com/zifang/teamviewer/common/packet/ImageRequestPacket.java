package com.zifang.teamviewer.common.packet;


import static com.zifang.teamviewer.common.interfaces.Command.*;

public class ImageRequestPacket extends Packet {
//    private String userId;
//

    public String getUserTo() {
        return userTo;
    }

    public void setUserTo(String userTo) {
        this.userTo = userTo;
    }

    public byte[] getBufferedImage() {
        return bufferedImage;
    }

    public void setBufferedImage(byte[] bufferedImage) {
        this.bufferedImage = bufferedImage;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

//    private String username;
//
//    private String password;
//
//    private String controllerId;


    private String userTo;

    private byte[] bufferedImage;
    private String message;

//    public String getUserId() {
//        return userId;
//    }
//
//    public void setUserId(String userId) {
//        this.userId = userId;
//    }
//
//    public String getUsername() {
//        return username;
//    }
//
//    public void setUsername(String username) {
//        this.username = username;
//    }
//
//    public String getPassword() {
//        return password;
//    }
//
//    public void setPassword(String password) {
//        this.password = password;
//    }
//    public String getControllerId() {
//        return controllerId;
//    }
//
//    public void setControllerId(String controllerId) {
//        this.controllerId = controllerId;
//    }

    @Override
    public Byte getCommand() {

        return IMAGE_REQUEST;
    }

    public Byte getVersion(){
        return version;
    }
}
