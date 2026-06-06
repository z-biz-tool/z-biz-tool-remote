package com.zifang.teamviewer.client.netty.main.lisener;

import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;

public class ClientKeyLisener implements KeyListener {
    @Override
    public void keyTyped(KeyEvent e) {

    }
    @Override
    public void keyPressed(KeyEvent e) {
        System.out.println(e.getKeyChar());
    }

    @Override
    public void keyReleased(KeyEvent e) {
        System.out.println(e.getExtendedKeyCode());
    }
}