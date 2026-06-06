package com.zifang.teamviewer.client.netty.main;


import com.zifang.teamviewer.client.netty.main.lisener.ClientKeyLisener;
import com.zifang.teamviewer.client.netty.main.lisener.ClientPanelListener;

import javax.swing.*;

public class MainControllerFrame extends JFrame{
    JPanel  jPanel = new JPanel();
    public MainControllerFrame(){
        //Dimension d = Toolkit.getDefaultToolkit().getScreenSize();
        jPanel.addMouseListener(new ClientPanelListener());
        this.addKeyListener(new ClientKeyLisener());
        this.add(jPanel);
        this.setSize(500,500);
        this.setVisible(true);
        this.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
    }

    public void refreshImage(){

//        JLabel background = new JLabel(new ImageIcon("/Users/zifang/Desktop/90dea9380f519896c2bd8de04a63e5d6.jpg"));
//
//        this.jPanel.add(background);
//        this.validate();
    }
    public static void main(String[] args) {
        MainControllerFrame mainControllerFrame = new MainControllerFrame();
        mainControllerFrame.refreshImage();
    }
}