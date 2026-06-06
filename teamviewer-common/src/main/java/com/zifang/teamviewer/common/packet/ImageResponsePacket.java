package com.zifang.teamviewer.common.packet;


import static com.zifang.teamviewer.common.interfaces.Command.*;


public class ImageResponsePacket extends Packet {


    public String getUserTo() {
        return userTo;
    }

    public void setUserTo(String userTo) {
        this.userTo = userTo;
    }

    private String userTo;

    private byte[] bufferedImage;
    private String message;

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


    @Override
    public Byte getCommand() {

        return IMAGE_RESPONSE;
    }
}
