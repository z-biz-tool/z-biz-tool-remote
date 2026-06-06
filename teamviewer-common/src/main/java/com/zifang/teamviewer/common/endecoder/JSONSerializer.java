package com.zifang.teamviewer.common.endecoder;

import com.alibaba.fastjson.JSON;
import com.zifang.teamviewer.common.interfaces.Serializer;
import com.zifang.teamviewer.common.interfaces.SerializerAlogrithm;

public class JSONSerializer implements Serializer {

    @Override
    public byte getSerializerAlogrithm() {
        return SerializerAlogrithm.JSON;
    }

    @Override
    public byte[] serialize(Object object) {

        return JSON.toJSONBytes(object);
    }

    @Override
    public <T> T deserialize(Class<T> clazz, byte[] bytes) {

        return JSON.parseObject(bytes, clazz);
    }
}
