package com.zifang.teamviewer.common.packet;

import com.alibaba.fastjson.annotation.JSONField;

/**
 * 抽象包
 * */
public abstract class Packet {
    /**
     * 协议版本
     */
    @JSONField(deserialize = false, serialize = false)
    public Byte version = 1;


    @JSONField(serialize = false)
    public abstract Byte getCommand();

    public Byte getVersion(){
        return this.version;
    }
}
